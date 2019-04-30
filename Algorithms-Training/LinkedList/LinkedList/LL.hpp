//
//  LL.hpp
//  
//
//  Created by Abraham Fraifeld on 4/26/19.
//
//

#ifndef LL_hpp
#define LL_hpp

#include <stdio.h>
#include <iostream>
#include <fstream>

template <class T>
class Node{
    
    public:
        T value;
    
        Node<T> * next;
        Node();
        Node(T value);
        void print_hello();
        void set_value(T newValue);
        void print_value();
        void set_next(Node * n);
        void equals(Node * n){
            return n->value == this->value;
        }
        void print(){
            std::cout << "\n"<< value << "\n";
        }
        Node<T> get_next();
    
    
};
#endif /* LL_hpp */


/*
 
 Node class definition
 
 */
template <class T>
Node<T>::Node(){
    value = NULL;
    next = NULL;
}

template <class T>
Node<T>::Node(T v){
    value = v;
    next = NULL;
}

template <class T>
void Node<T>::print_hello()
{
    std::cout << "Hello World";
}

template <class T>
void Node<T>::set_value(T newValue)
{
    value = newValue;
}

template <class T>
void Node<T>::print_value(){
    std::cout << value << "\n";
}

template <class T>
void Node<T>::set_next(Node<T> * n){
    this -> next = n;
}

template <class T>
Node<T> Node<T>::get_next(){
    return *next;
}



/* linked list class */

template <class T>
class list{
public:
    Node<T> * head;
    Node<T> * tail;
    bool head_set; // turns true as soon as the head node gets a value
    int length; // maintains the length of the list
    
    //functions
    list();
    void prepend(T value);  // prepends a value to the list
    void append(T value); // appends a value to the list
    void insertAt(int index,T value); // inserts a value at a given index
    void replace(T value_1, T value_2, int instance = 1); // replaces any number of instances of value_1 with value_2
    void set(int index, T value); // replaces the value at a given index
    void readFile(std::string filePath);
    
    int indexOf(T value, int instance = 1); // returns the index of a given value
    Node<T> * at(int index); // returns the value at a given index
    T operator[] (const int index);
    
    void deleteFront(); // deletes the head node and replaces it with the second node in the list
    void deleteTail(); // deletes the tail node
    void deleteIndex(int index); // deletes the node at a given index
    void clear(); // clears a list
    
    
    void printList(); //prints each element of the list
    
    void addList(list l); //appends a given list to the current list
    bool equals(list l); //checks list equality
    void assign(list l); // replaces a list with a given list
    
    
};

template <class T>
list<T>::list(){
    
    /*
     Initialize the list as follows
     1. head is a node with null value
     2. tail is a node with null value
     3. list looks like head --> tail --> null
     4. since the head's value is not set, set head_set to false. This avoids confusion in the future because null looks like 0 when printing.
     5. set the length to 0
     */
    head = new Node<T>;
    head->value = NULL;
    tail = new Node<T>;
    head->next=tail;
    tail->next = NULL;
    tail->value = NULL;
    head_set = false;
    length = 0;
}


template <class T>
void list<T>::prepend(T value){
    //If head is not set, just change its value
    if (head_set == false)
    {
        head->set_value(value);
        head_set = true;
    }

    //If head is set, insert a node in front of head and make the new node the head.
    else{
        Node<T> *newNode = new Node<T>;
        newNode->set_value(value);
        newNode->set_next(head);
        head = newNode;
    }
    //make sure the length is updated to reflect the new node
    length++;
}

template <class T>
void list<T>::append(T value){
    if (head_set == false)
    {
        head->set_value(value);
        head_set = true;
    }
    else{
        Node<T> *newTail = new Node<T>;
        tail->set_value(value);
        tail->set_next(newTail);
        tail = newTail;
    }
    length++;

}

template <class T>
void list<T>::insertAt(int index,T value){
    
    if(index <= 0)
        this->prepend(value);
    else if (index == length)
    {
        this->append(value);
        
    }
    else{
    
        // Create the node to be inserted
        Node<T> * newNode = new Node<T>(value);
    
    
        Node<T> * iterator = head;
        for (int i = 0; i < index-1; i++)
        {
            try{
                if(i != length)
                {
                    iterator = iterator->next;
                }
                else
                {
                    throw 1;
                }
            }
            catch (int e){
                std::cout << "Tried to insert value past the tail (" << index << ") ...returning \n";
                return;
            }
        }
        
        newNode->next = iterator->next;
        iterator->next = newNode;
        length++;

        }

}

template <class T>
void list<T>::readFile(std::string filePath) // reads a new line delimited file of floats into the list.
{
    std::ifstream inFile;
    inFile.open(filePath);
    if (!inFile) { // if the filePath is invalid
        std::cout << "No file with path " << filePath << "\n";
        exit(1); // terminate with error
    }
    std::string line;
    while (std::getline(inFile, line))
    {
        float v = std::stof(line.c_str());
        this->append(T(v));
    }
    inFile.close();
}

template <class T>
void list<T>::replace(T value_1, T value_2, int instance)
{
    int count = 0;
    
    Node<T> * iterator = head;
    
    for(int i = 0; i < length; i++)
    {
        if (iterator->value == value_1)
        {
            iterator->value = value_2;
            count++;
        }
        if (count == instance )
        {
            return;
        }
        iterator = iterator->next;
    }
    

}

template <class T>
void list<T>::set(int index, T value)
{
    Node<T> * iterator = head;
    
    for(int i = 0; i < index; i++)
    {
        iterator = iterator->next;
    }
    iterator->set_value(value);
    
    
}


template <class T>
void list<T>::deleteFront(){
    
    if (length<=1)
    {
        head = new Node<T>();
        length = 0;
        return;
    }
    
    Node<T>* temp = head;
    head = head->next;
    length --;
    delete temp;
}

template <class T>
void list<T>::deleteTail(){
    
    if (length<=1)
    {
        head = new Node<T>();
        length = 0;
        return;
    }
    
    
    Node<T>* temp = head;
    for (int i = 0; i < length-1; i ++)
    {
        temp = temp->next;
    }
    tail = temp;
    
    delete tail->next;
    tail->next = NULL;
    length --;
}

template <class T>
void list<T>::deleteIndex(int index)
{
    if (index ==0)
    {
        deleteFront();
        return;
    }
    if (index == length-1)
    {
        deleteTail();
        return;
    }
    if (index >= length)
    {
        std::cout << "ERROR: Delete index " << index << " out of bounds. \n";
        return;
    }
    
    if (index < 0)
    {
        return;
    }
    
    Node<T>* temp = head;
    for (int i = 0; i < index-1; i ++)
    {
        temp = temp->next;
    }
    
    Node<T> * newLink = temp->next->next;
    delete temp->next;
    temp->next = newLink;
    length--;
    

}

template <class T>
void list<T>::clear(){
    while(length>0)
        deleteFront();
    head_set = false;
    this->head = new Node<T>();
    this->tail = new Node<T>();
    head->next = tail;
    length = 0;
}

template <class T>
int list<T>::indexOf(T v, int instance)
{
    Node<T> * iterator = head;
    int count = 1;
    for (int i = 0; i < length; i ++)
    {
        if (iterator->value == v && count == instance)
        {
            return i;
        }
        else if (iterator->value == v)
        {
            count = count + 1;
        }

        iterator = iterator->next;
    }
    std::cout << v << " not found.\n";
    return -1;
    
}

template <class T>
Node<T> * list<T>::at(int index){
    Node<T> * iterator = head;
    for(int i = 0; i < index; i++)
    {
        iterator = iterator->next;
    }
    T val = iterator -> value;
    return iterator;
    
}

template <class T>
T list<T>::operator[] (const int index){
    return this->at(index)->value;
}



template <class T>
void list<T>::printList(){
    if (length ==0)
    {
         std::cout << "Empty list.\n";
    }
    Node<T> * iter = head;
    for (int i = 0; i < length; i++)
    {
        std::cout << iter->value << "\n";
        iter = iter->next;
    }
}

template <class T>
void list<T>::addList(list<T> l)
{
    Node<T> * adder = l.head;
    for (int i = 0; i < l.length; i++)
    {
        this->append(adder->value);
        adder = adder->next;
    }
    delete adder;
}

template <class T>
bool list<T>::equals(list<T> otherList)
{
    if (this->length != otherList.length)
        return false;
    else{
        Node<T>* checker = this->head;
        Node<T>* otherChecker = otherList.head;
        for (int i = 0; i < length; i ++)
        {
            if (checker->value != otherChecker->value)
                return false;
            checker = checker->next;
            otherChecker = otherChecker->next;
        }
        delete checker;
        delete otherChecker;
        return true;
    }
}


template <class T>
void list<T>::assign(list<T> l){
    this->clear();
    Node<T>  * l_iterator = l.head;
    for (int i = 0; i < l.length; i++)
    {
        this->append(l_iterator->value);
        l_iterator = l_iterator->next;
    }
    length = l.length;
    delete l_iterator;

}






